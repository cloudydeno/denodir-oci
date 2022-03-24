// https://stackoverflow.com/a/53593328/3582903
// TODO: return Uint8Array instead of string
export function stableJsonStringify<T=unknown>( obj: T )
{
    var allKeys: string[] = [];
    var seen: Record<string,null> = {};
    JSON.stringify(obj, function (key, value) {
        if (!(key in seen)) {
            allKeys.push(key);
            seen[key] = null;
        }
        return value;
    });
    allKeys.sort();
    return JSON.stringify(obj, allKeys);
}
