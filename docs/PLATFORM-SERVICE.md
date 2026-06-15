# Running as a Background Service

obsync can run `obsync watch` continuously in the background without an open
terminal, starting on login and restarting automatically if it stops.

### macOS (launchd)

```bash
obsync install-service    # registers a launchd agent (~/Library/LaunchAgents/)
obsync service status      # check if it's running
obsync uninstall-service   # remove it
```

Logs: `~/.obsync/logs/watch.{out,err}.log`

### Linux (systemd --user)

```bash
obsync install-service    # registers ~/.config/systemd/user/obsync-watch.service
obsync service status      # check if it's running
obsync uninstall-service   # remove it
```

To keep obsync running after you log out (e.g. over SSH), enable linger for
your user once (requires sudo on most distros):

```bash
sudo loginctl enable-linger $(whoami)
```

Without this, the systemd `--user` instance (and `obsync-watch.service`) stops
when your last session ends. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if
`obsync install-service` reports that it could not enable linger automatically.

Logs: `~/.obsync/logs/watch.{out,err}.log` (same paths as macOS)

### Windows

Background service management (`install-service`/`uninstall-service`/
`service status`) is not yet available on Windows. Run obsync directly
instead:

```bash
obsync watch
```

Keep the terminal window open, or use Windows Task Scheduler or a terminal
multiplexer to keep it running. Native Windows service support is planned for
a future release.
