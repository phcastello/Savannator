const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function printUsage() {
  console.log("Uso:\nnpm start -- --profile <nome> [--show]");
}

export function parseCliArgs(args) {
  let profile;
  let show = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

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

  if (!profile) {
    throw new Error("O argumento --profile é obrigatório.");
  }

  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new Error(
      "Nome de perfil inválido. Use apenas letras, números, _ e -.",
    );
  }

  return { profile, show };
}
