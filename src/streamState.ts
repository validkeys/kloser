/**
 * Stream lifecycle states.
 * 
 * @remarks
 * Valid state transitions:
 * - streaming → settling, redirecting, failed
 * - settling → accepting, rejecting, redirecting
 * - accepting → completed, failed
 * - rejecting → failed
 * - redirecting → streaming, failed
 * - completed → (terminal)
 * - failed → (terminal)
 */
export type StreamStatus =
	| "streaming"    // Currently receiving data
	| "settling"     // Stream ended, waiting for user action
	| "accepting"    // Accept in progress
	| "rejecting"    // Reject in progress
	| "redirecting"  // Redirect in progress
	| "completed"    // Successfully accepted
	| "failed";      // Rejected or errored

/**
 * Finite state machine for tracking stream lifecycle.
 * 
 * @remarks
 * Prevents race conditions by enforcing valid state transitions and
 * serializing concurrent operations. Each transition has an associated
 * operation that is executed atomically.
 * 
 * If an operation throws, the state is rolled back to the previous state
 * and the error is re-thrown. This ensures the state machine remains
 * consistent even when operations fail.
 * 
 * Transitions are sequential - concurrent transitions wait for the
 * current one to complete before attempting the next.
 * 
 * @example
 * ```typescript
 * const machine = new StreamStateMachine();
 * 
 * // Transition from streaming to settling
 * const success = await machine.transitionTo("settling", async () => {
 *   // Perform settling operation
 *   await applyFinalText();
 * });
 * 
 * if (!success) {
 *   console.log("Invalid transition");
 * }
 * ```
 */
export class StreamStateMachine {
	private status: StreamStatus = "streaming";
	private transition: Promise<void> = Promise.resolve();

	/**
	 * Gets the current state of the machine.
	 */
	get current(): StreamStatus {
		return this.status;
	}

	/**
	 * Attempts to transition to a new state and execute an operation.
	 * 
	 * @param newStatus - Target state to transition to
	 * @param operation - Async operation to perform during transition
	 * @returns Promise resolving to true if transition succeeded, false if invalid
	 * @throws If operation throws, state is rolled back and error re-thrown
	 * 
	 * @remarks
	 * This method is the core of the state machine:
	 * 
	 * 1. Waits for any in-progress transition to complete (serialization)
	 * 2. Checks if the transition is valid from the current state
	 * 3. If invalid, returns false immediately
	 * 4. If valid, starts the transition:
	 *    - Updates state to newStatus
	 *    - Executes the operation
	 *    - If operation succeeds, keeps new state
	 *    - If operation fails, rolls back to old state and re-throws
	 * 
	 * Previous transition errors are drained (caught and ignored) before
	 * validating the new transition. This allows retrying after failures.
	 * 
	 * @example
	 * ```typescript
	 * // Valid transition
	 * const success = await machine.transitionTo("settling", async () => {
	 *   await applyText();
	 * });
	 * console.log(success); // true
	 * 
	 * // Invalid transition
	 * const invalid = await machine.transitionTo("accepting", async () => {
	 *   // Won't execute - invalid from current state
	 * });
	 * console.log(invalid); // false
	 * 
	 * // Transition with error (state rolled back)
	 * try {
	 *   await machine.transitionTo("accepting", async () => {
	 *     throw new Error("oops");
	 *   });
	 * } catch (err) {
	 *   // State is rolled back, can retry
	 *   console.log(machine.current); // still "settling"
	 * }
	 * ```
	 */
	async transitionTo(
		newStatus: StreamStatus,
		operation: () => Promise<void>
	): Promise<boolean> {
		// Wait for any in-progress transition (ignore errors - they were handled by original caller)
		await this.transition.catch(() => {});

		// Check if transition is valid
		if (!this.isValidTransition(this.status, newStatus)) {
			return false;
		}

		// Start new transition
		this.transition = (async () => {
			const oldStatus = this.status;
			this.status = newStatus;

			try {
				await operation();
			} catch (err) {
				// Rollback on error
				this.status = oldStatus;
				throw err;
			}
		})();

		await this.transition;
		return true;
	}

	private isValidTransition(from: StreamStatus, to: StreamStatus): boolean {
		const validTransitions: Record<StreamStatus, StreamStatus[]> = {
			streaming: ["settling", "redirecting", "failed"],
			settling: ["accepting", "rejecting", "redirecting"],
			accepting: ["completed", "failed"],
			rejecting: ["failed"],
			redirecting: ["streaming", "failed"],
			completed: [],
			failed: [],
		};

		return validTransitions[from]?.includes(to) ?? false;
	}
}
