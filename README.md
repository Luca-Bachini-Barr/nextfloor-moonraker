# NextFloor Moonraker

A [NextFloor](https://github.com/therealMRBK/NextFloor) plugin (plugin API 1) for 3D printers run by Klipper/Moonraker through the [Moonraker integration](https://github.com/marcolivierarsenault/moonraker-home-assistant).

## What it does

- **Marker**: the printer's marker shows `42% · 1h 12m` while printing and `Paused · 42%`, `Finished` or `Error` otherwise. It is highlighted while a print is running or paused.
- **Tap**: a tap on the marker (or on furniture linked to the same sensor) opens a window in the corner of the 3D view with:
  - state, file name and printer message
  - progress bar with layers
  - time left, elapsed and finish time
  - nozzle / bed / chamber temperatures with targets
  - the slicer thumbnail and the printer camera (still or live)
  - QIDI Box filament-change status, when the integration provides it
  - optional Pause / Resume / Cancel buttons (Pause and Cancel ask first)

  Tap again to close.

The plugin handles `sensor.<printer>_current_print_state` and finds the printer's other entities on the same Home Assistant device, so no setup is needed.

While the integration reports the printer unavailable (switched off or not connected), the marker and the window say **Off / not connected** and the window hides everything else. The integration notices a printer that was switched off after its next poll, so this can take up to about a minute.

## Install

1. HACS → ⋮ → Custom repositories → add this repository as **Dashboard**, then download it.
2. NextFloor → **Extensions → Plugins** → add `/hacsfiles/nextfloor-moonraker/nextfloor-moonraker.js?v=1.2.1`.
   Home Assistant lets browsers cache `/hacsfiles` files for a month, so after each update change the `?v=` to the
   new version (or the app keeps running the old copy).
3. In the editor, place `sensor.<printer>_current_print_state` as a device where the printer stands (room → Devices → Place).
   NextFloor only passes taps to plugins for placed devices.

## Device settings

In the placed device's form:

| Setting | Default |
|---|---|
| Show the print's thumbnail | on |
| Show the camera | on |
| Camera picture: still (refreshes) / live | still |
| Pause / Resume / Cancel buttons | on |
