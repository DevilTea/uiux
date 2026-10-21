/**
 * Default CLI line writers: a command's own, user-requested output (it may include a Token or
 * invite code on purpose), so it is not redacted. Sanctioned for stdio in `eslint.config.js`.
 */
export const writeStdoutLine = (line: string): void => console.log(line)
export const writeStderrLine = (line: string): void => console.error(line)
