export class ServerVersion {
    protected parts: string[] = [];
    protected numericParts: number[] = [];
    protected suffix: string;
    protected readonly compatible: boolean;

    constructor(public readonly versionString: string) {
        const temp = versionString.split('-');
        const main = temp.shift();
        this.suffix = temp.join('-');
        if (main) {
            this.parts = main.split('.');
            this.numericParts = this.parts.map((part) => {
                const value = Number(part);
                return Number.isNaN(value) ? 0 : value;
            });
        }
        this.compatible = this.suffix.startsWith('ws') && this.parts.length >= 2;
    }
    public equals(a: ServerVersion | string): boolean {
        const versionString = typeof a === 'string' ? a : a.versionString;
        return this.versionString === versionString;
    }
    public gt(a: ServerVersion | string): boolean {
        if (this.equals(a)) {
            return false;
        }
        const other = typeof a === 'string' ? new ServerVersion(a) : a;
        const maxLength = Math.max(this.numericParts.length, other.numericParts.length);
        for (let i = 0; i < maxLength; i++) {
            const current = this.numericParts[i] ?? 0;
            const opponent = other.numericParts[i] ?? 0;
            if (current !== opponent) {
                return current > opponent;
            }
        }
        if (this.suffix !== other.suffix) {
            return this.suffix > other.suffix;
        }
        return false;
    }
    public isCompatible(): boolean {
        return this.compatible;
    }
}
