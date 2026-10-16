# The crystal ball: what we know

Notes from poking at the device on 2026-10-17. Facts here were observed on the real ball
unless marked as an assumption.

## The device

Sold as an "Electronic crystal ball" (manual **UM-ER-02**, "Electronic ball"). It's a 70 mm
ball: the top half is a glass dome lens over a round screen, and the bottom half is a matte shell.

| | |
| --- | --- |
| Screen | Round, 480 × 480 |
| Storage | 4 GB, shown to a computer as a USB drive |
| Battery | 800 mAh, 2–4 hours of playback |
| Connector | USB-C (data + charging) |
| Controls | Dial key: middle = hold 3 s for power; left/right = previous/next clip, hold for volume |
| Sound | Small speaker |

### Getting it onto a computer

1. Turn the ball **off** (hold the middle button for 3 seconds).
2. Plug it in with a **data** USB-C cable. Charge-only cables are common and show nothing.
3. Hold the middle button until a USB icon appears on the screen.

The manual says it needs a USB 3.0 port. It doesn't: the device is USB 2.0 high speed.

## USB identity

| Field | Value |
| --- | --- |
| Product string | `EVDO-M4` |
| Manufacturer string | `EVDO` |
| Vendor ID | `0x33C3`: **ArtInChip Technology** (广东匠芯创) |
| Product ID | `0xFFFF` |
| bcdDevice / bcdUSB | `0x0200` / `0x0110`, but it enumerates at high speed (480 Mb/s) |
| Serial | `2022123456` (placeholder) |
| Interfaces | One: mass storage (class 0x08), SCSI transparent (0x06), bulk-only (0x50) |
| SCSI INQUIRY | vendor and product blank, revision `0.01` |

There is no HID, CDC or vendor-specific interface in normal mode, so the running firmware offers
no control channel besides the disk.

## Storage layout

- Whole disk: 4,016,046,080 bytes (7,843,840 sectors of 512 B), MBR partition table.
- One FAT32 partition starting at **4 MiB**: 4,011,851,776 bytes, 32 KiB clusters, volume name `NO NAME`.
- The 4 MiB before the partition has not been read. Raw reads (`/dev/rdiskN`) need root on macOS,
  and the first attempt was abandoned. It may be just alignment padding, or it may be where the
  firmware lives if the ball exposes its whole SD/eMMC. Worth a `sudo dd` look one day.
- Top level holds `video/`, plus Windows/macOS litter (`System Volume Information`,
  `.Spotlight-V100`, `.Trashes`, `.fseventsd`). The manual says not to rename or delete `video/`.

Factory contents of `video/` (all saved in the app's "Original videos" theme):
`星空1.mp4`, `星空2.mp4`, `星空3.mp4` ("starry sky" demos) and five `IMG_*.mp4` clips.

## Video format the player accepts

Taken from the factory demos (`星空*.mp4`, muxed by `Lavf52.104.0`):

| | Factory demo | What this app writes |
| --- | --- | --- |
| Container | MP4 (`isom`, `moov` after `mdat`) | same |
| Video | H.264 Constrained Baseline, level 3.0, 480 × 480, yuv420p, ~29.97 fps, ~1 Mb/s | H.264 Constrained Baseline, level 3.0, 480 × 480, yuv420p, 30 fps, ~1.8 Mb/s |
| Audio | MP3, 44.1 kHz stereo, 128 kb/s | same |
| Length | 15–212 s | 15–16 s built-ins; any length for your own clips |

The `IMG_*` clips on the ball were H.264 **Main** profile at ~3 Mb/s with 320 kb/s MP3, so the
decoder accepts more than Baseline. Baseline is used anyway as the safe choice.

Assumptions not yet verified on the device:
- clips play in file-name order (the app names them `01-…`, `02-…`);
- the player loops the whole folder;
- a video with no audio track would play (the app always adds a silent MP3 track, like the factory files).

## macOS quirks

- `diskutil info diskN` **hangs** on this device (and on the MSI monitor's driver disk). Use
  `ioreg -r -n EVDO-M4 -l -w0` for the BSD name and `mount` for the mount point. `diskutil eject` works.
- `cp`, Finder and `fs.copyFile` carry extended attributes, which FAT stores as `._name.mp4`
  AppleDouble files. The player may try to play them. The app copies with plain streams and
  deletes any `._*` files it finds.
- Volume names collide (`NO NAME`, `NO NAME 1`), so never assume a mount path.

## The chip and its firmware

VID `0x33C3` belongs to ArtInChip, which makes RISC-V display SoCs (D12x, D13x, D21x) and the
open-source **Luban-Lite** RTOS SDK (<https://github.com/artinchip/luban-lite>). Qiming Zhixian
(启明智显) sells a D211-based chip called **M4**, so "EVDO-M4" is probably that chip under a toy
maker's brand. Unconfirmed until we read `GET_HWINFO` or open the ball.

### USB upgrade mode (BROM)

ArtInChip's boot ROM has a USB upgrade mode, documented at
<http://doc.panel-tag.cn/m4/ic/brom/usb_mode.html> and on artinchip.com:

- It enumerates as **VID `0x33C3` / PID `0x6677`** with one vendor-specific (`0xFF`) bulk-only interface.
- BROM commands: `GET_HWINFO 0x00`, `GET_TRACEINFO 0x01`, `WRITE 0x02`, `READ 0x03` (any
  CPU-visible address), `EXEC 0x04`, `JTAG_UNLOCK 0x06`, `BOOT_CONTINUE 0x07`, plus the firmware
  component commands `0x10`–`0x15`.
- Ways in:
  1. Hold the **UPGRADE-BOOT** pin/key while the chip powers on. Which pin, and whether a button
     is wired to it on this board, is unknown. Likely needs the ball opened.
  2. A software reboot with reboot reason `REBOOT_REASON_UPGRADE` in the WRI register, which is what
     the `aicupg` console command does (`application/baremetal/bootloader/cmd/aicupg.c` in
     Luban-Lite). Needs the ball's debug UART console, which means opening it.
  3. Every boot medium failing. **Not an option**: it means a bricked ball.

### A read-only dump path

The Luban-Lite bootloader's upgrade stage implements `UPG_MODE_DUMP_PARTITION` with
`GET_STORAGE_MEDIA`, `GET_PARTITION_TABLE` and `READ_FWC_DATA`
(`application/baremetal/bootloader/lib/aicupg/fwc_cmd.c`). So once the ball is in upgrade mode,
the vendor's own protocol can read partitions back without writing flash: download a bootloader
for the right chip into RAM via BROM, run it, then issue the read commands. The host side
(ArtInChip's AiBurn) is Windows-only, so a small pyusb client would be needed on macOS.

### Where this stopped

The family's goal was themed videos, which the stock firmware already does, so firmware work was
parked. To resume: confirm the chip with `GET_HWINFO`, find the upgrade pin or the UART, then
dump with the bootloader's read commands and load the image into REA/Ghidra (RISC-V).

## References

- ArtInChip BROM USB upgrade mode: <http://doc.panel-tag.cn/m4/ic/brom/usb_mode.html>
- Upgrade mode entry: <https://www.artinchip.com/knowledge/oxy_ex-1/topics/brom-upgradeStartMode.html>
- AICUPG flow: <https://www.artinchip.com/knowledge/oxy_ex-1/topics/aicupg-burn-luban.html>
- Luban-Lite SDK: <https://github.com/artinchip/luban-lite>
- Another ArtInChip USB display reverse-engineered (different protocol, PID `0x0E02`): <https://github.com/hevnsnt/artinchip-linux>
