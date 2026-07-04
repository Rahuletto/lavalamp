import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def parse_args():
    rows = 42
    cols = 120
    args = sys.argv[1:]
    command_start = -1
    i = 0
    while i < len(args):
        if args[i] == "--":
            command_start = i + 1
            break
        if args[i] == "--rows" and i + 1 < len(args):
            rows = int(args[i + 1])
            i += 2
            continue
        if args[i] == "--cols" and i + 1 < len(args):
            cols = int(args[i + 1])
            i += 2
            continue
        raise SystemExit(f"unknown argument: {args[i]}")
    if command_start == -1 or command_start >= len(args):
        raise SystemExit("missing command after --")
    return rows, cols, args[command_start:]


def set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def drain(master_fd):
    while True:
        try:
            data = os.read(master_fd, 65536)
        except OSError as error:
            if error.errno in (errno.EIO, errno.EAGAIN):
                return
            raise
        if not data:
            return
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def main():
    rows, cols, command = parse_args()
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        env = os.environ.copy()
        env["TERM"] = env.get("TERM", "xterm-256color")
        os.execvpe(command[0], command, env)
        raise SystemExit(127)

    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    set_nonblocking(master_fd)
    stdin_fd = sys.stdin.fileno()
    set_nonblocking(stdin_fd)

    def terminate(_signum, _frame):
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)

    stdin_open = True
    while True:
        fds = [master_fd]
        if stdin_open:
            fds.append(stdin_fd)
        readable, _, _ = select.select(fds, [], [], 0.05)
        if master_fd in readable:
            drain(master_fd)
        if stdin_open and stdin_fd in readable:
            try:
                data = os.read(stdin_fd, 65536)
            except BlockingIOError:
                data = b""
            if data:
                os.write(master_fd, data)
            else:
                stdin_open = False
        wait_pid, status = os.waitpid(child_pid, os.WNOHANG)
        if wait_pid == child_pid:
            drain(master_fd)
            os.close(master_fd)
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
                sys.stderr.write(f"\nLAVALAMP_E2E_CHILD_EXIT code={code}\n")
                sys.stderr.flush()
                raise SystemExit(code)
            if os.WIFSIGNALED(status):
                code = 128 + os.WTERMSIG(status)
                sys.stderr.write(f"\nLAVALAMP_E2E_CHILD_EXIT code={code}\n")
                sys.stderr.flush()
                raise SystemExit(code)
            sys.stderr.write("\nLAVALAMP_E2E_CHILD_EXIT code=1\n")
            sys.stderr.flush()
            raise SystemExit(1)


if __name__ == "__main__":
    main()
