const path = require('path');
const fs = require('fs');

/**
 * Load configuration from the single repo-root .env.
 *
 * There used to be several: backend/.env for the API, the same file read again
 * by the simulator via a relative path, plus two committed templates that had
 * already drifted apart. Which one won depended on the working directory a
 * process happened to start in, so the API and the simulator could disagree
 * about the database they were talking to.
 *
 * Everything now reads the root file. Requiring this module more than once is
 * harmless -- dotenv never overwrites a variable that is already set, which is
 * also why values injected by Docker Compose always take precedence.
 */
const ROOT_ENV = path.resolve(__dirname, '..', '.env');

// Legacy location, still honoured so an existing checkout keeps working after
// this change. Remove once deployments have moved their file to the root.
const LEGACY_ENV = path.resolve(__dirname, '.env');

require('dotenv').config({ path: ROOT_ENV });

if (fs.existsSync(LEGACY_ENV)) {
    require('dotenv').config({ path: LEGACY_ENV });
    if (!process.env.FIXAM_ENV_WARNED) {
        process.env.FIXAM_ENV_WARNED = '1';
        console.warn(
            `[config] backend/.env is deprecated -- move any settings it still holds into ${ROOT_ENV} and delete it. `
            + 'Values already set (root .env, or the environment) win.'
        );
    }
}

module.exports = { ROOT_ENV, LEGACY_ENV };
