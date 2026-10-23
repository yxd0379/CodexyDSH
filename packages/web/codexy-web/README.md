# CodexyDSH Web

This bundle supplies the native Harness Web interface over the Codexy base runtime. The shared sidebar, conversation, settings, directory picker, and file-upload components remain native packages. The `standard` preset uses the product-wide Codexy tool registrations rather than mounting a second set of upstream tools.

The base's `/compact`, plan mode, web search/fetch, and user-question providers remain enabled for Web sessions.

The Web listener defaults to `127.0.0.1:3082`; invocation options can select another host or port. Configuration and conversations use the independent product home. The bundle mounts memory, usage, draft, and command APIs without loading the former Codexy UI packages.

Remote workspaces use the same native interface through a cached standalone server and an authenticated SSH tunnel. The local sidebar contributes only Host-qualified navigation; uploads, files, terminals, model settings and conversations stay with the remote Client. The directory browser selects the machine before listing paths. The original plugin installer and browser graph modification are not mounted.
