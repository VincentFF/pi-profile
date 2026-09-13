# Changelog

## [0.2.0](https://github.com/VincentFF/pi-profile-switch/compare/pi-profile-switch-v0.1.0...pi-profile-switch-v0.2.0) (2026-09-13)


### Features

* default profile plan and controlled loader seam ([bc8da2c](https://github.com/VincentFF/pi-profile-switch/commit/bc8da2cb79bb58d70bc242a4363e068c4f4a2cdd))
* discovery-first extension references ([2a2ddef](https://github.com/VincentFF/pi-profile-switch/commit/2a2ddef1982ce27783ae28bb1f45a748dc86c98a))
* in-session profile switching, reload, and rollback (ticket 05) ([d713516](https://github.com/VincentFF/pi-profile-switch/commit/d71351650bf4d2a26dd5d2d21ca06a6bbd5f34d5))
* named global profiles via generated settings (ticket 02) ([e75f575](https://github.com/VincentFF/pi-profile-switch/commit/e75f575d7bce70c1fcf0e34f05a5ce65ebc67d1c))
* passthrough launcher spawning real pi (ADR-0005) ([9e42018](https://github.com/VincentFF/pi-profile-switch/commit/9e420189f5ccb12bcdc1a2f891fd4ca9326fdb55))
* persistent profile-scoped /mcp enable|disable (ticket 10) ([326a050](https://github.com/VincentFF/pi-profile-switch/commit/326a050dfad67f717f8c1d7337006085992c8901))
* pi-mcp-adapter coordination via pi.events (ticket 04) ([cb61edb](https://github.com/VincentFF/pi-profile-switch/commit/cb61edbf571970655e68f5f8c6111b5ff8bcbffe))
* profile catalog CRUD with replacement-guarded delete (ticket 09) ([2d8354a](https://github.com/VincentFF/pi-profile-switch/commit/2d8354ac70ee04ac86b05a2ea7a108d8331a49ff))
* profile host with default-profile launcher ([1711cc9](https://github.com/VincentFF/pi-profile-switch/commit/1711cc931676d8b46e4a8f797723d4f7cfff2bf5))
* profile selector, /profile list, and /profile status surface (ticket 07) ([6b1eb73](https://github.com/VincentFF/pi-profile-switch/commit/6b1eb737bb2fed4c8df85d654f737c5df3c31f3e))
* project trust gating, project catalogs, scope-aware state (ticket 03) ([665e51c](https://github.com/VincentFF/pi-profile-switch/commit/665e51c3a77d56661ecce5c5063af9423f1daece))
* release artifacts, schemas, examples, and acceptance docs (ticket 12) ([d0520ac](https://github.com/VincentFF/pi-profile-switch/commit/d0520ac6c7ca1ab5d6b75d0c1fb9f2b71a71879a))
* resource-registry CRUD with referrer-guarded delete (ticket 08) ([29a745e](https://github.com/VincentFF/pi-profile-switch/commit/29a745e911ab872cef97167b76239ca47bf1061a))
* runtime overlay customize/reset with alwaysOn protection (ticket 06) ([f6258b1](https://github.com/VincentFF/pi-profile-switch/commit/f6258b1db427648f8950d2ef733d3b6693d84826))
* scaffold package and launcher arg parsing ([6c1aeab](https://github.com/VincentFF/pi-profile-switch/commit/6c1aeab6de916c4abf7583db81d74c730cefba28))
* sweep stale runtime dirs at startup by pid liveness ([18bb8ee](https://github.com/VincentFF/pi-profile-switch/commit/18bb8eefb5f050281223585af48899d9014ca040))
* TUI-only CRUD gating and structured RPC status (ticket 11) ([801b4c3](https://github.com/VincentFF/pi-profile-switch/commit/801b4c345a1d1222e0edbbcb163d8599867daa2f))


### Bug Fixes

* address review findings in launcher and tests ([da16b63](https://github.com/VincentFF/pi-profile-switch/commit/da16b6302a127d4916e751176962b8253f388ef3))
* harden project trust mirror and settings merge after ticket 03 review ([99fd4a2](https://github.com/VincentFF/pi-profile-switch/commit/99fd4a2082eddacf7899f572941eb161ceb7a24d))
