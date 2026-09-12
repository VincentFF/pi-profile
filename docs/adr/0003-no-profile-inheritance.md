# No profile inheritance

Profiles do not support inheritance: no `extends`, no deep merge, no array append. A project profile with the same name fully replaces the global one; variants are created by copying a complete definition in the CRUD wizard under a new name.

Inheritance would be hard to retrofit once users depend on replacement semantics, so the simple rule is chosen now: every profile definition is self-contained and readable without resolving a parent chain.
