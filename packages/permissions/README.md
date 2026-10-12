# Codexy Permissions

`codexyPermissions` configures named sandbox, approval and reviewer presets. `/permission` switches only the current Session; settings choose the default for new Sessions. The catalog keeps `permissionPresets/catalog` and the Session projection keeps `permissions` for client integration.

`approve-for-me` is available while the automatic approval reviewer is active. `auto` is available while per-tool review is active. Restoration requires each selected integration to be present. Product policy and preset events use the Codexy durable fact carrier while sandbox changes use the public DSH policy setter.
