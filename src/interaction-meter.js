const WINDOW_MS = 60_000;

export function interactionBand(perMinute) {
  if (perMinute < 8) return { name: "VERMELHO", ansi: 31 };
  if (perMinute < 15) return { name: "AMARELO", ansi: 33 };
  if (perMinute < 30) return { name: "VERDE", ansi: 32 };
  return { name: "AZUL", ansi: 34 };
}

export function createInteractionMeter(label, {
  now = () => Date.now(),
  write = (line) => console.log(line),
  colors = Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
} = {}) {
  let timestamps = [];
  let first = 0;

  return {
    record() {
      const current = now();
      timestamps.push(current);
      while (first < timestamps.length && timestamps[first] <= current - WINDOW_MS) {
        first += 1;
      }
      if (first > 1_000 && first * 2 > timestamps.length) {
        timestamps = timestamps.slice(first);
        first = 0;
      }

      const perMinute = timestamps.length - first;
      const band = interactionBand(perMinute);
      const value = `${perMinute}/min ${band.name}`;
      const colored = colors ? `\x1b[${band.ansi}m${value}\x1b[0m` : value;
      write(`Ritmo ${label} (últimos 60s): ${colored}`);
      return perMinute;
    },
  };
}
