"""Codex stdio transport. Runtime capability checks live in Chat.connect."""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading


# These overrides affect this child only, never the user's Codex configuration.
SECURITY_CONFIG = {
    'sandbox_mode': 'read-only', 'approval_policy': 'never',
    'approvals_reviewer': 'user', 'model_provider': 'openai',
    'web_search': 'disabled', 'agents.enabled': False,
    'apps._default.enabled': False, 'project_doc_max_bytes': 0,
    'tools.experimental_request_user_input.enabled': False,
    'tools.update_plan.enabled': False,
    'skills.include_instructions': False, 'skills.bundled.enabled': False,
    'notify': [], 'analytics.enabled': False,
    'include_environment_context': False,
    **{'features.' + name: False for name in (
        'shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'memories',
        'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
        'browser_use_full_cdp_access', 'computer_use', 'in_app_browser',
        'code_mode', 'code_mode_only', 'code_mode_prewarm',
        'shell_snapshot', 'shell_snapshot_v2', 'skill_search',
        'skill_mcp_dependency_install', 'request_permissions_tool',
        'image_generation', 'view_image', 'tool_suggest', 'recommended_plugins',
        'deferred_executor', 'goals', 'daemon_auto_start',
        'sleep_tool', 'token_budget', 'current_time_reminder',
    )},
    'features.skip_host_skill_discovery': True,
    # Some Codex models use the official V8 orchestration wrapper even with
    # code_mode=false. It has no Node/filesystem/network and only registered tools.
    'features.code_mode_host': True,
}


class CodexError(RuntimeError):
    pass


class ProcessGroup:
    """Own descendants too, including after their immediate parent exits."""
    def __init__(self, proc):
        self.proc, self.handle = proc, None
        if os.name != 'nt':
            return
        import ctypes
        from ctypes import wintypes as w

        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                ('flags', w.DWORD), ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t),
                ('active_processes', w.DWORD), ('affinity', ctypes.c_size_t),
                ('priority', w.DWORD), ('scheduling', w.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('process_memory', ctypes.c_size_t),
                ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        handle = self.kernel.CreateJobObjectW(None, None)
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not handle or not self.kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.kernel.AssignProcessToJobObject(handle, int(proc._handle)):
            if handle:
                self.kernel.CloseHandle(handle)
            proc.kill()
            proc.wait(timeout=5)
            raise CodexError('Codex 자식 프로세스 종료 경계를 설정하지 못했습니다. 연결을 중단합니다.')
        self.handle = handle

    def close(self):
        if os.name == 'nt':
            if self.handle:
                self.kernel.CloseHandle(self.handle)
                self.handle = None
        else:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def executable_path(value):
    found = shutil.which(value) or (str(Path(value).resolve()) if Path(value).is_file() else None)
    if not found:
        raise CodexError('Codex 실행 파일을 찾지 못했습니다. 설치 후 codex_executable 설정을 확인하세요.')
    # Avoid cmd.exe/shell interpolation. npm shims can be resolved to their native binary.
    if os.name == 'nt' and Path(found).suffix.lower() in ('.cmd', '.bat', '.ps1'):
        package = Path(found).parent/'node_modules/@openai/codex'
        native = list(package.rglob('codex.exe')) if package.is_dir() else []
        if len(native) != 1:
            raise CodexError('Windows에서는 실제 codex.exe 경로를 설정하세요. 셸 스크립트는 실행하지 않습니다.')
        found = str(native[0])
    return found


def child_environment():
    env = os.environ.copy()
    # Authentication stays inside the installed Codex. Do not forward API keys or
    # parent-agent session identifiers into this independent product process.
    for key in list(env):
        if (key.upper() in ('OPENAI_API_KEY', 'OPENAI_BASE_URL')
                or key.upper().startswith('PASEO_')
                or (key.upper().startswith('CODEX_') and key.upper() != 'CODEX_HOME')):
            env.pop(key, None)
    return env


def config_args(config):
    def toml(value):
        if isinstance(value, dict):
            return '{'+', '.join(json.dumps(key)+' = '+toml(item) for key, item in value.items())+'}'
        return json.dumps(value, ensure_ascii=False)
    args = []
    for key, value in config.items():
        args.extend(['-c', key + '=' + toml(value)])
    return args


class StdioRPC:
    """One owned process; reader never blocks waiting for a server tool response."""
    def __init__(self, executable, cwd, on_event, on_request, on_exit, *, overrides=None, command=None, timeout=20, env=None):
        self.timeout = timeout
        self.on_event, self.on_request, self.on_exit = on_event, on_request, on_exit
        self.pending, self.sequence = {}, 0
        self.lock, self.write_lock = threading.Lock(), threading.Lock()
        self.closed = False
        self.proc = None
        if command is None:
            executable = executable_path(executable)
            command = [executable, 'app-server', '--listen', 'stdio://', *config_args({**SECURITY_CONFIG, **(overrides or {})})]
        self.proc = subprocess.Popen(command, cwd=cwd, env=child_environment() if env is None else env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            start_new_session=os.name != 'nt')
        self.group = ProcessGroup(self.proc)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        # Drain stderr, but never store or return it: upstream may log local config/account data.
        self.err_reader = threading.Thread(target=self._drain, daemon=True)
        self.err_reader.start()

    def _drain(self):
        while self.proc.stderr.read(4096):
            pass

    def send(self, message):
        with self.write_lock:
            if self.closed or self.proc.poll() is not None:
                raise CodexError('Codex 연결이 종료됐습니다. 다시 연결하세요.')
            try:
                self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
                self.proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise CodexError('Codex에 메시지를 전달하지 못했습니다.') from exc

    def call(self, method, params):
        response = queue.Queue(maxsize=1)
        with self.lock:
            self.sequence += 1
            request_id = self.sequence
            self.pending[request_id] = response
        try:
            self.send({'id': request_id, 'method': method, 'params': params})
            try:
                message = response.get(timeout=self.timeout)
            except queue.Empty as exc:
                raise CodexError(f'Codex 응답 시간 초과 ({method}). 자동 재전송하지 않습니다.') from exc
            if 'error' in message:
                # A bounded diagnostic, never a raw response/config/account dump.
                raise CodexError(str(message['error'].get('message', 'Codex 오류'))[:500])
            return message['result']
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def _read(self):
        try:
            while line := self.proc.stdout.readline(2_000_001):
                if len(line) > 2_000_000:
                    raise CodexError('Codex 메시지 크기 제한 초과')
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise CodexError('Codex 메시지 형식 오류')
                if 'method' in message:
                    if 'id' in message:
                        self.on_request(message)
                    else:
                        self.on_event(message)
                else:
                    with self.lock:
                        waiter = self.pending.get(message.get('id'))
                    if waiter:
                        waiter.put_nowait(message)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, CodexError, queue.Full):
            pass
        finally:
            with self.lock:
                for waiter in self.pending.values():
                    try:
                        waiter.put_nowait({'error': {'message': 'Codex 프로세스 연결이 끊겼습니다.'}})
                    except queue.Full:
                        pass
            if not self.closed:
                self.on_exit()

    def close(self):
        if self.closed:
            return
        self.closed = True
        if not self.proc:
            return
        # Let app-server flush its thread store on EOF before forcefully reaping
        # our process tree. Closing the job also handles a parent that already died.
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=3)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        self.group.close()
        if self.proc.poll() is None:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name != 'nt':
                    os.killpg(self.proc.pid, signal.SIGKILL)
                else:
                    self.proc.kill()
                self.proc.wait(timeout=5)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
