# Launcher-based initial profile selection

Pi's public Extension API has no pre-start resource-filter seam, so a `pi --profile review` flag cannot strictly filter resources before the first agent turn. Instead, the `pi-profile` launcher binary resolves the profile before creating the Pi runtime and hands the Pi SDK's ResourceLoader a filtered resource graph. Plain `pi` remains the native entry point and always starts with the built-in `default` profile. Reversing this decision requires upstream Pi API support for pre-start resource filtering.
