const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const VALID_MODES = new Set(["comment", "reply"]);

export function printUsage() {
  console.log(
    [
      "Uso:",
      "npm start -- --profile <nome> [--show]",
      "npm start -- --mode comment --profile <nome> [--show]",
      "npm start -- --mode reply",
    ].join("\n"),
  );
}

export function parseCliArgs(args) {
  let mode;
  let profile;
  let show = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--mode") {
      if (mode !== undefined) {
        throw new Error("O argumento --mode deve ser informado apenas uma vez.");
      }

      mode = args[index + 1];
      index += 1;

      if (!mode || mode.startsWith("--")) {
        throw new Error("Informe comment ou reply depois de --mode.");
      }
      continue;
    }

    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) {
        throw new Error("O argumento --mode deve ser informado apenas uma vez.");
      }

      mode = argument.slice("--mode=".length);
      continue;
    }

    if (argument === "--profile") {
      if (profile !== undefined) {
        throw new Error("O argumento --profile deve ser informado apenas uma vez.");
      }

      profile = args[index + 1];
      index += 1;

      if (!profile || profile.startsWith("--")) {
        throw new Error("Informe um nome depois de --profile.");
      }
      continue;
    }

    if (argument.startsWith("--profile=")) {
      if (profile !== undefined) {
        throw new Error("O argumento --profile deve ser informado apenas uma vez.");
      }

      profile = argument.slice("--profile=".length);
      continue;
    }

    if (argument === "--show") {
      if (show) {
        throw new Error("O argumento --show deve ser informado apenas uma vez.");
      }

      show = true;
      continue;
    }

    throw new Error(`Argumento desconhecido: ${argument}`);
  }

  mode ??= "comment";

  if (!VALID_MODES.has(mode)) {
    throw new Error('Modo inválido. Use apenas "comment" ou "reply".');
  }

  if (mode === "comment" && !profile) {
    throw new Error("O argumento --profile é obrigatório.");
  }

  if (profile !== undefined && !PROFILE_NAME_PATTERN.test(profile)) {
    throw new Error(
      "Nome de perfil inválido. Use apenas letras, números, _ e -.",
    );
  }

  if (mode === "reply" && show) {
    throw new Error("O argumento --show não pode ser usado no modo reply.");
  }

  return { mode, profile, show };
}
