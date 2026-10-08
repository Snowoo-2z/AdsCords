export interface ParsedCommand {
  command: string;
  args: string[];
}

export function parsePrefixCommand(content: string, prefix: string): ParsedCommand | null {
  if (!content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length).trim();
  if (!body) return null;

  const [command = '', ...args] = body.split(/\s+/u);
  return { command: command.toLowerCase(), args };
}
