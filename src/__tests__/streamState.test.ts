import { describe, it } from "node:test";
import * as assert from "node:assert";
import { StreamStateMachine, StreamStatus } from "../streamState";

describe("StreamStateMachine", () => {
	describe("initial state", () => {
		it("starts in streaming state", () => {
			const machine = new StreamStateMachine();
			assert.strictEqual(machine.current, "streaming");
		});
	});

	describe("valid transitions from streaming", () => {
		it("can transition to settling", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("settling", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "settling");
		});

		it("can transition to redirecting", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("redirecting", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "redirecting");
		});

		it("can transition to failed", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("failed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "failed");
		});
	});

	describe("invalid transitions from streaming", () => {
		it("rejects transition to accepting", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("accepting", async () => {
				executed = false;
			});
			
			assert.strictEqual(result, false);
			assert.strictEqual(executed, false);
			assert.strictEqual(machine.current, "streaming");
		});

		it("rejects transition to rejecting", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("rejecting", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, false);
			assert.strictEqual(executed, false);
			assert.strictEqual(machine.current, "streaming");
		});

		it("rejects transition to completed", async () => {
			const machine = new StreamStateMachine();
			let executed = false;
			
			const result = await machine.transitionTo("completed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, false);
			assert.strictEqual(executed, false);
			assert.strictEqual(machine.current, "streaming");
		});
	});

	describe("valid transitions from settling", () => {
		it("can transition to accepting", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("accepting", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "accepting");
		});

		it("can transition to rejecting", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("rejecting", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "rejecting");
		});

		it("can transition to redirecting", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("redirecting", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "redirecting");
		});
	});

	describe("valid transitions from accepting", () => {
		it("can transition to completed", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			await machine.transitionTo("accepting", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("completed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "completed");
		});

		it("can transition to failed", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			await machine.transitionTo("accepting", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("failed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "failed");
		});
	});

	describe("valid transitions from rejecting", () => {
		it("can transition to failed", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			await machine.transitionTo("rejecting", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("failed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "failed");
		});
	});

	describe("valid transitions from redirecting", () => {
		it("can transition to streaming", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("redirecting", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("streaming", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "streaming");
		});

		it("can transition to failed", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("redirecting", async () => {});
			
			let executed = false;
			const result = await machine.transitionTo("failed", async () => {
				executed = true;
			});
			
			assert.strictEqual(result, true);
			assert.strictEqual(executed, true);
			assert.strictEqual(machine.current, "failed");
		});
	});

	describe("terminal states", () => {
		it("completed is terminal - rejects all transitions", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("settling", async () => {});
			await machine.transitionTo("accepting", async () => {});
			await machine.transitionTo("completed", async () => {});
			
			const states: StreamStatus[] = ["streaming", "settling", "accepting", "rejecting", "redirecting", "failed"];
			
			for (const state of states) {
				const result = await machine.transitionTo(state, async () => {});
				assert.strictEqual(result, false, `Should reject transition from completed to ${state}`);
				assert.strictEqual(machine.current, "completed");
			}
		});

		it("failed is terminal - rejects all transitions", async () => {
			const machine = new StreamStateMachine();
			await machine.transitionTo("failed", async () => {});
			
			const states: StreamStatus[] = ["streaming", "settling", "accepting", "rejecting", "redirecting", "completed"];
			
			for (const state of states) {
				const result = await machine.transitionTo(state, async () => {});
				assert.strictEqual(result, false, `Should reject transition from failed to ${state}`);
				assert.strictEqual(machine.current, "failed");
			}
		});
	});

	describe("operation execution and error handling", () => {
		it("executes operation during transition", async () => {
			const machine = new StreamStateMachine();
			const events: string[] = [];
			
			await machine.transitionTo("settling", async () => {
				events.push("operation executed");
			});
			
			assert.deepStrictEqual(events, ["operation executed"]);
			assert.strictEqual(machine.current, "settling");
		});

		it("rolls back state on operation error", async () => {
			const machine = new StreamStateMachine();
			const error = new Error("operation failed");
			
			await assert.rejects(
				async () => {
					await machine.transitionTo("settling", async () => {
						throw error;
					});
				},
				error
			);
			
			// State should be rolled back to original
			assert.strictEqual(machine.current, "streaming");
		});

		it("allows retry after failed operation", async () => {
			const machine = new StreamStateMachine();
			
			// First attempt fails
			await assert.rejects(
				async () => {
					await machine.transitionTo("settling", async () => {
						throw new Error("first attempt");
					});
				},
				{ message: "first attempt" }
			);
			
			// State rolled back, should still be streaming
			assert.strictEqual(machine.current, "streaming");
			
			// Second attempt succeeds
			const result = await machine.transitionTo("settling", async () => {});
			assert.strictEqual(result, true);
			assert.strictEqual(machine.current, "settling");
		});
	});

	describe("concurrent transition handling", () => {
		it("serializes concurrent transitions", async () => {
			const machine = new StreamStateMachine();
			const events: string[] = [];
			
			// Start first transition with delay
			const promise1 = machine.transitionTo("settling", async () => {
				events.push("transition1 start");
				await new Promise(resolve => setTimeout(resolve, 50));
				events.push("transition1 end");
			});
			
			// Give first transition time to start
			await new Promise(resolve => setTimeout(resolve, 10));
			
			// Start second transition - should wait for first to complete
			const promise2 = machine.transitionTo("accepting", async () => {
				events.push("transition2 start");
				events.push("transition2 end");
			});
			
			await Promise.all([promise1, promise2]);
			
			// First transition should complete before second starts
			assert.deepStrictEqual(events, [
				"transition1 start",
				"transition1 end",
				"transition2 start",
				"transition2 end"
			]);
			
			assert.strictEqual(machine.current, "accepting");
		});

		it("waits for in-progress transition before validating next", async () => {
			const machine = new StreamStateMachine();
			
			// Start slow transition
			const promise1 = machine.transitionTo("settling", async () => {
				await new Promise(resolve => setTimeout(resolve, 50));
			});
			
			// Immediately try invalid transition from streaming
			// Should wait for first transition, then reject based on new state (settling)
			const promise2 = machine.transitionTo("streaming", async () => {});
			
			await promise1;
			const result2 = await promise2;
			
			// Second transition should be rejected (streaming is not valid from settling)
			assert.strictEqual(result2, false);
			assert.strictEqual(machine.current, "settling");
		});

		it("handles rapid successive valid transitions", async () => {
			const machine = new StreamStateMachine();
			
			// Chain of valid transitions
			const p1 = machine.transitionTo("settling", async () => {});
			const p2 = machine.transitionTo("accepting", async () => {});
			const p3 = machine.transitionTo("completed", async () => {});
			
			await Promise.all([p1, p2, p3]);
			
			assert.strictEqual(machine.current, "completed");
		});
	});

	describe("complex state transition sequences", () => {
		it("handles full success flow: streaming → settling → accepting → completed", async () => {
			const machine = new StreamStateMachine();
			
			await machine.transitionTo("settling", async () => {});
			assert.strictEqual(machine.current, "settling");
			
			await machine.transitionTo("accepting", async () => {});
			assert.strictEqual(machine.current, "accepting");
			
			await machine.transitionTo("completed", async () => {});
			assert.strictEqual(machine.current, "completed");
		});

		it("handles reject flow: streaming → settling → rejecting → failed", async () => {
			const machine = new StreamStateMachine();
			
			await machine.transitionTo("settling", async () => {});
			assert.strictEqual(machine.current, "settling");
			
			await machine.transitionTo("rejecting", async () => {});
			assert.strictEqual(machine.current, "rejecting");
			
			await machine.transitionTo("failed", async () => {});
			assert.strictEqual(machine.current, "failed");
		});

		it("handles redirect flow: streaming → redirecting → streaming → settling", async () => {
			const machine = new StreamStateMachine();
			
			await machine.transitionTo("redirecting", async () => {});
			assert.strictEqual(machine.current, "redirecting");
			
			await machine.transitionTo("streaming", async () => {});
			assert.strictEqual(machine.current, "streaming");
			
			await machine.transitionTo("settling", async () => {});
			assert.strictEqual(machine.current, "settling");
		});

		it("handles redirect from settling: settling → redirecting → streaming", async () => {
			const machine = new StreamStateMachine();
			
			await machine.transitionTo("settling", async () => {});
			assert.strictEqual(machine.current, "settling");
			
			await machine.transitionTo("redirecting", async () => {});
			assert.strictEqual(machine.current, "redirecting");
			
			await machine.transitionTo("streaming", async () => {});
			assert.strictEqual(machine.current, "streaming");
		});
	});
});
