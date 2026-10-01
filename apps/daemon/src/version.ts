// The version is defined once, in the root package.json, and every program reads it.
import rootPackage from "../../../package.json" with { type: "json" };

export const VERSION: string = rootPackage.version;
