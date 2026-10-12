# @codexydsh/browser-session

The product Host controller owns Session business behavior. This Host plugin publishes the unchanged DSH 0.2.1-alpha.2 browser Session factory through the public authenticated Web server, preserving its original module ID and dependencies. Both Web and Desktop use this browser object layer.

The released ClientModuleRegistry discovers browser modules only from active Host entries. This plugin adds the public Session module to its exposed graph and the index injection table without activating the stock Host controller. Initial boot and live graph readers share an identity-stable graph; disposal restores the original method and removes the route and listener.
