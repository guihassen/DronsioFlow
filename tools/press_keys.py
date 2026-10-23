"""Test tool: holds a key combo on a temporary uinput keyboard.
Usage: python3 press_keys.py <hold_seconds> <evdev codes...>   e.g. 2.5 29 125
"""
import fcntl, os, struct, sys, time

def ioc(d, t, nr, size):
    return (d << 30) | (size << 16) | (ord(t) << 8) | nr

hold = float(sys.argv[1])
codes = [int(c) for c in sys.argv[2:]]
fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
fcntl.ioctl(fd, ioc(1, "U", 100, 4), 1)
fcntl.ioctl(fd, ioc(1, "U", 100, 4), 0)
for c in range(1, 256):
    fcntl.ioctl(fd, ioc(1, "U", 101, 4), c)
fcntl.ioctl(fd, ioc(1, "U", 3, 92), struct.pack("HHHH80sI", 3, 1, 1, 1, b"dronsio-test-keyboard", 0))
fcntl.ioctl(fd, ioc(0, "U", 1, 0))
time.sleep(4)  # let the helper discover the device (rescans every 3 s)
ev = lambda t, c, v: os.write(fd, struct.pack("llHHi", 0, 0, t, c, v))
for c in codes:
    ev(1, c, 1); ev(0, 0, 0); time.sleep(0.03)
time.sleep(hold)
for c in reversed(codes):
    ev(1, c, 0); ev(0, 0, 0); time.sleep(0.03)
time.sleep(0.5)
fcntl.ioctl(fd, ioc(0, "U", 2, 0))
