# Launcher-based initial profile selection

**Superseded by [ADR-0005](0005-subprocess-host-with-generated-settings.md), and then by [ADR-0007](0007-pure-extension-runtime.md), which removes the launcher entirely.** ADR-0005 disproved the premise ("no pre-start resource-filter seam") by finding Pi's settings mechanism; ADR-0007 dropped both the settings seam and the launcher because the host process broke Pi's session layout and third-party extension state. Kept for history.

Pi's public Extension API has no pre-start resource-filter seam, so a `pi --profile review` flag cannot strictly filter resources before the first agent turn. Instead, the `pi-profile` launcher binary resolves the profile before creating the Pi runtime and hands the Pi SDK's ResourceLoader a filtered resource graph. Plain `pi` remains the native entry point and always starts with the built-in `default` profile. Reversing this decision requires upstream Pi API support for pre-start resource filtering.
