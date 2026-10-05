interface ITestService {
    add(x: number, y: number | string): number;
    subtract(x: number, y: number): number;
}

export const TestService: ITestService = {

    /**
     * Adds two numbers.
     * @param x - The first operand.
     * @param y - The second operand; if a string, it must be parseable as a finite number.
     * @returns The sum of x and y.
     * @throws {RangeError} If y is a string that cannot be parsed as a finite number.
     */
    add(x, y) {
        const n = typeof y === "string" ? parseFloat(y) : y;
        if (!isFinite(n)) throw new RangeError(`add: cannot convert "${y}" to a finite number`);
        return x + n;
    },

    /**
     * Subtracts y from x.
     * @param x - The minuend.
     * @param y - The subtrahend.
     * @returns The difference of x and y.
     */
    subtract(x, y) { return x - y; },

}
