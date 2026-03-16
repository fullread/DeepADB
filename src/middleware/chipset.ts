/**
 * Chipset Detection — Shared chipset family identification, modem path mapping,
 * and SIM configuration detection.
 *
 * Used by at-commands.ts, baseband.ts, and device-profiles.ts to avoid
 * duplicated detection logic. Single source of truth for chipset family
 * classification, known modem device node paths, and dual SIM detection.
 */

/**
 * Known modem device node paths by chipset family.
 * Ordered by likelihood — detection tries each path until one responds.
 */
export const MODEM_PATHS: Record<string, string[]> = {
  // Samsung Shannon/Exynos (Pixel 6, 6a, 7, 7a, 8, Samsung Galaxy S series)
  shannon: [
    "/dev/umts_router0",
    "/dev/umts_router1",
    "/dev/umts_atc0",
  ],
  // Qualcomm (most Android devices)
  qualcomm: [
    "/dev/smd11",
    "/dev/smd7",
    "/dev/smd0",
    "/dev/at_channel0",
    "/dev/at_mdm0",
  ],
  // MediaTek (many mid-range devices)
  mediatek: [
    "/dev/radio/atci-serv-fw",
    "/dev/ccci_ioctl0",
    "/dev/ttyC0",
    "/dev/ttyC1",
  ],
  // Unisoc/Spreadtrum
  unisoc: [
    "/dev/stty_lte0",
    "/dev/stty_nr0",
    "/dev/stty_w0",
  ],
  // HiSilicon/Kirin (Huawei, Honor devices)
  hisilicon: [
    "/dev/appvcom0",
    "/dev/appvcom9",
    "/dev/acm_at",
  ],
  // Intel XMM (older iPhones via Android projects, some Samsung/Asus devices)
  intel: [
    "/dev/ttyIFX0",
    "/dev/ttyACM0",
    "/dev/ttyACM1",
  ],
  // Generic USB/serial modems
  generic: [
    "/dev/ttyUSB0",
    "/dev/ttyUSB1",
    "/dev/ttyUSB2",
    "/dev/ttyACM0",
    "/dev/ttyACM1",
  ],
};

/**
 * Detect the chipset family from device properties.
 * Returns the family key for MODEM_PATHS lookup.
 */
export function detectChipsetFamily(props: Record<string, string>): string {
  const chipname = (props["ro.hardware.chipname"] ?? "").toLowerCase();
  const platform = (props["ro.board.platform"] ?? "").toLowerCase();
  const hardware = (props["ro.hardware"] ?? "").toLowerCase();
  const soc = (props["ro.soc.model"] ?? "").toLowerCase();

  // Shannon/Exynos detection (includes Google Tensor SoCs which use Samsung Shannon modems)
  if (chipname.includes("exynos") || chipname.includes("s5e") ||
      soc.includes("exynos") || soc.includes("shannon") ||
      hardware.includes("samsungexynos") || platform.includes("exynos") ||
      platform.includes("gs101") || platform.includes("gs201") ||
      platform.includes("zuma") || platform.includes("zumapro")) {
    return "shannon";
  }

  // Qualcomm detection (includes platform codenames for recent SoCs)
  if (platform.includes("msm") || platform.includes("sdm") || platform.includes("sm") ||
      platform.includes("qcom") || chipname.includes("snapdragon") ||
      hardware.includes("qcom") || platform.includes("lahaina") ||
      platform.includes("taro") || platform.includes("kalama")) {
    return "qualcomm";
  }

  // MediaTek detection
  if (platform.includes("mt") || chipname.includes("mt") ||
      hardware.includes("mt") || platform.includes("mediatek")) {
    return "mediatek";
  }

  // Unisoc detection
  if (platform.includes("sp") || platform.includes("ums") ||
      chipname.includes("unisoc") || chipname.includes("spreadtrum")) {
    return "unisoc";
  }

  // HiSilicon/Kirin detection (Huawei, Honor devices)
  if (platform.includes("kirin") || chipname.includes("kirin") ||
      platform.includes("hi3") || platform.includes("hi6") ||
      chipname.includes("hisilicon") || hardware.includes("kirin") ||
      soc.includes("kirin") || soc.includes("hisilicon")) {
    return "hisilicon";
  }

  // Intel XMM detection (older modem platforms)
  if (chipname.includes("xmm") || chipname.includes("intel") ||
      platform.includes("intel") || soc.includes("xmm")) {
    return "intel";
  }

  return "generic";
}

export interface SimConfig {
  dualSim: boolean;
  simSlots: number;
  multisimMode: string;
}

/** Maximum SIM slots to prevent resource exhaustion from corrupted properties. */
const MAX_SIM_SLOTS = 4;

/**
 * Detect SIM configuration from device properties.
 * Returns dual SIM status, slot count, and multisim mode string.
 */
export function detectSimConfig(props: Record<string, string>): SimConfig {
  const activeModems = parseInt(props["telephony.active_modems.max_count"] ?? "1", 10) || 1;
  const multisimMode = (props["persist.radio.multisim.config"] ?? "").toLowerCase();
  const dualSim = activeModems >= 2 || multisimMode === "dsds" || multisimMode === "dsda" || multisimMode === "tsts";
  const simSlots = dualSim ? Math.min(Math.max(activeModems, 2), MAX_SIM_SLOTS) : 1;

  return { dualSim, simSlots, multisimMode };
}
