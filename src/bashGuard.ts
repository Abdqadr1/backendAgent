// PreToolUse hook for the coding agent: blocks Bash commands that match BLOCKED_BASH anywhere in the
// command line (prefix deny rules alone miss `cd x && bash -c "curl ..."`). Exit code 2 blocks the call
// and the stderr text is shown to the agent.
import { BLOCKED_BASH } from "./blocked.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = String(JSON.parse(input)?.tool_input?.command ?? "");
  } catch {
    process.stderr.write("Blocked: could not read the command.");
    process.exit(2);
  }
  if (BLOCKED_BASH.some((r) => r.test(cmd))) {
    process.stderr.write(`Not allowed in this sandbox: "${cmd}". Pushing and network/infra commands are handled outside the agent.`);
    process.exit(2);
  }
  process.exit(0);
});
