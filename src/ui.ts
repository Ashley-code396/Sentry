export const reset = "\x1b[0m";
export const dim = "\x1b[2m";
export const green = "\x1b[32m";
export const yellow = "\x1b[33m";
export const red = "\x1b[31m";
export const cyan = "\x1b[36m";
export const bold = "\x1b[1m";

export const BANNER = `${bold}   ____  _____ _   _ _____ _____  ____${reset}
${bold}  / ___|| ____| \\ | |_   _|_   _|/ ___|${reset}
${bold}  \\___ \\|  _| |  \\| | | |   | |  \\___ \\${reset}
${bold}   ___) | |___| |\\  | | |   | |   ___) |${reset}
${bold}  |____/|_____|_| \\_| |_|   |_|  |____/${reset}  ${dim}autonomous position-risk agent · KeeperHub${reset}`;

export function banner(): void {
  console.log(BANNER);
  console.log("");
}

export function ok(msg: string): void {
  console.log(`  ${green}✔${reset} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${red}✘${reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow}!${reset} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${cyan}›${reset} ${msg}`);
}

export function meter(value: number, danger: number): string {
  const width = 26;
  const ratio = Math.min(1, Math.max(0, value / (danger * 2)));
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const color = value <= danger ? red : value <= danger * 1.4 ? yellow : green;
  return `${color}${bar}${reset}`;
}

export function section(title: string): void {
  console.log(`\n${bold}${title}${reset}`);
}
