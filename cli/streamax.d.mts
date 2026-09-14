export type CliDependencies = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

export function runCli(
  args: string[],
  dependencies?: CliDependencies,
): Promise<number>;
