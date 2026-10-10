//#region lib/types/index.js
/**
 * dsh-arrow-navigator node half.
 *
 * The whole feature is browser presentation and input routing, so the host body
 * is intentionally empty: it exists only so the Loader has a host-side row for
 * the package, while the browser half ships through the package's `./client`
 * export and is served by the client module system.
 */
/** Host plugin body — this package contributes browser behavior only. */
function apply() {}
//#endregion
export { apply };
