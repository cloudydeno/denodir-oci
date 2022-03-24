// Based on https://stackoverflow.com/a/53593328/3582903
export function stableJsonSerialize<T=unknown>(obj: T) {
    var allKeys = new Array<string>();
    var seen = new Set<string>();
    JSON.stringify(obj, function (key, value) {
        if (!seen.has(key)) {
            allKeys.push(key);
            seen.add(key);
        }
        return value;
    });
    allKeys.sort();
    const json = JSON.stringify(obj, allKeys);
    return new TextEncoder().encode(json);
}
