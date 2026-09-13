import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { FakeChild } from "./update-candidate-canary.test-support.js";

export function registerCanaryReadinessBudgetTests(
  root: () => string,
  spawnMock: Mock<
    (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => FakeChild
  >,
) {
  it.each([
    ["lint", "Checking data migrations", "Checking update health"],
    ["startup", "Checking update recovery", "Checking Gateway startup"],
    ["config", undefined, "Checking configuration"],
  ] as const)("attributes %s failures to their check", async (phase, previous, name) => {
    let now = 2_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    const spawnNormally = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation((command, args, options) => {
      const fails = phase === "config" && args.includes("validate");
      if (!args.includes("--fix") && !fails) {
        return spawnNormally(command, args, options);
      }
      const child = new FakeChild(42_000);
      queueMicrotask(() => {
        child.stderr.write(
          fails ? "Configuration unavailable\n" : "Earlier check completed successfully\n",
        );
        now += fails ? 25 : 0;
        child.emit("close", fails ? 1 : 0);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary({
      root: root(),
      stateDir: root(),
      config: {},
      env: {},
      timeoutMs: 1_000,
      onStep: (step) => {
        now += step.name === previous ? 1_000 : phase === "config" ? 100 : 0;
      },
    });
    const failed = result.steps.at(-1);
    const durationMs = phase === "config" ? 25 : 0;
    expect(result).toMatchObject({ status: "error", phase });
    expect(result.durationMs).toBe(phase === "config" ? 425 : 1_000);
    expect(failed).toMatchObject({ name, durationMs, exitCode: 1 });
    expect(failed?.failureFacts?.[0]?.message).toContain(
      phase === "config" ? "Configuration unavailable" : "deadline exceeded",
    );
    expect(failed?.stderrTail).not.toContain("Earlier check");
    expect(result.logTail.join("\n")).toContain("Earlier check completed successfully");
  });

  it.each(
    ["startupz", "readyz"].flatMap((endpoint) =>
      ["headers", "body"].map((delay) => ({ endpoint, delay })),
    ),
  )("allows slow $endpoint $delay within the validation budget", async ({ endpoint, delay }) => {
    const timers = new Set<NodeJS.Timeout>();
    const server = createServer((request, response) => {
      const body = JSON.stringify({ status: "started", ready: true });
      const headers = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      };
      if (request.url !== `/${endpoint}`) {
        headers();
        response.end(body);
        return;
      }
      if (delay === "body") {
        headers();
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (delay === "headers") {
          headers();
        }
        response.end(body);
      }, 1_200);
      timers.add(timer);
      response.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
    const fetchHttp = globalThis.fetch;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback HTTP listener");
      }
      vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
        fetchHttp(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options),
      );
      const result = await validateUpdateCandidateCanary({
        root: root(),
        stateDir: root(),
        config: {},
        env: {},
        timeoutMs: 6_000,
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.logTail.join("\n")).toContain("startupz: started");
      expect(result.logTail.join("\n")).toContain("readyz: ready");
    } finally {
      vi.unstubAllGlobals();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
}
