import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { dwsError } from "./errors.js";

export type SpawnFunction = (
  executable: string,
  args: string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

export function runDwsJson({
  executable,
  args,
  env,
  timeoutMs,
  maxOutputBytes,
  spawnImpl = nodeSpawn as SpawnFunction
}: {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  spawnImpl?: SpawnFunction
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env
      });
    } catch {
      reject(dwsError("dws_process_spawn_failed"));
      return;
    }

    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };

    const failAndKill = (error: unknown) => {
      finish(() => {
        child.kill("SIGKILL");
        reject(error);
      });
    };

    const captureStdout = (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        failAndKill(
          dwsError("dws_process_output_too_large", {
            maxOutputBytes
          })
        );
        return;
      }
      stdout.push(Buffer.from(chunk));
    };

    const countStderr = (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        failAndKill(
          dwsError("dws_process_output_too_large", {
            maxOutputBytes
          })
        );
      }
    };

    child.stdout?.on("data", captureStdout);
    child.stderr?.on("data", countStderr);

    const timer = setTimeout(() => {
      failAndKill(
        dwsError("dws_process_timed_out", {
          timeoutMs
        })
      );
    }, timeoutMs);
    timer.unref();

    child.once("error", () => {
      finish(() => reject(dwsError("dws_process_spawn_failed")));
    });

    child.once("close", (code, signal) => {
      finish(() => {
        if (signal) {
          reject(dwsError("dws_process_terminated"));
          return;
        }
        if (code !== 0) {
          reject(
            dwsError("dws_command_failed", {
              exitCode: code
            })
          );
          return;
        }

        const serialized = Buffer.concat(stdout)
          .toString("utf8")
          .replace(/^\uFEFF/, "")
          .trim();
        if (!serialized) {
          reject(dwsError("dws_command_returned_empty_output"));
          return;
        }
        try {
          resolve(JSON.parse(serialized));
        } catch {
          reject(dwsError("dws_command_returned_non_json"));
        }
      });
    });
  });
}
