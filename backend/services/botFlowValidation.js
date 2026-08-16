/**
 * Check a questionnaire definition before it can be saved.
 *
 * This runs on the server, not in the editor. The editor's job is to make good
 * definitions easy to write; this one's job is to make bad ones impossible to
 * store, because a malformed definition does not fail in an admin's browser --
 * it fails in a citizen's conversation, halfway through, with no way out.
 *
 * Returns an array of human-readable problems. Empty means it is fit to save.
 */

const STEP_TYPES = ['text', 'number', 'choice'];

const MAX_STEPS = 10;
const MAX_OPTIONS = 10;
const MAX_PROMPT = 500;

// Above this a questionnaire stops being a few follow-up questions and starts
// being a form people abandon. Not an error -- the institution may have a good
// reason -- but the editor says so.
const ADVISORY_STEP_COUNT = 5;

function isFilledString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/** A translations map must at least carry usable English. */
function checkTranslated(field, label, errors, { required = true, max = MAX_PROMPT } = {}) {
    if (field === undefined || field === null) {
        if (required) errors.push(`${label} is missing.`);
        return;
    }
    if (typeof field !== 'object' || Array.isArray(field)) {
        errors.push(`${label} must be an object of translations, for example { "en": "…" }.`);
        return;
    }
    if (!isFilledString(field.en)) {
        errors.push(`${label} needs English text.`);
        return;
    }
    if (field.en.length > max) {
        errors.push(`${label} is too long (${field.en.length} characters, limit ${max}).`);
    }
}

function validateDefinition(definition) {
    const errors = [];
    const warnings = [];

    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        return { errors: ['The questionnaire must be an object.'], warnings };
    }

    if (definition.intro !== undefined) checkTranslated(definition.intro, 'The introduction', errors, { required: false });
    if (definition.outro !== undefined) checkTranslated(definition.outro, 'The closing message', errors, { required: false });

    const steps = definition.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        errors.push('A questionnaire needs at least one question.');
        return { errors, warnings };
    }
    if (steps.length > MAX_STEPS) {
        errors.push(`A questionnaire may have at most ${MAX_STEPS} questions (this one has ${steps.length}).`);
    }
    if (steps.length > ADVISORY_STEP_COUNT) {
        warnings.push(`${steps.length} questions is a lot to ask over WhatsApp. `
            + 'Expect more people to stop part-way the longer it gets.');
    }

    const seenKeys = new Set();

    steps.forEach((step, index) => {
        const position = `Question ${index + 1}`;

        if (!step || typeof step !== 'object') {
            errors.push(`${position} is not a question.`);
            return;
        }

        // The key names the answer wherever it is later read -- on the report,
        // in the export, in any analysis -- so it has to be stable and machine
        // safe, not prose.
        if (!isFilledString(step.key)) {
            errors.push(`${position} needs a key.`);
        } else if (!/^[a-z][a-z0-9_]{0,39}$/.test(step.key)) {
            errors.push(`${position}: the key "${step.key}" must be lower case letters, `
                + 'numbers and underscores, starting with a letter.');
        } else if (seenKeys.has(step.key)) {
            errors.push(`${position}: the key "${step.key}" is used more than once. `
                + 'Answers are stored against the key, so a repeat would overwrite the earlier answer.');
        } else {
            seenKeys.add(step.key);
        }

        if (!STEP_TYPES.includes(step.type)) {
            errors.push(`${position}: "${step.type}" is not a question type. `
                + `Use one of: ${STEP_TYPES.join(', ')}.`);
        }

        checkTranslated(step.prompt, `${position}'s prompt`, errors);
        if (step.help !== undefined) {
            checkTranslated(step.help, `${position}'s help text`, errors, { required: false, max: 300 });
        }

        if (step.type === 'choice') {
            const options = step.options;
            if (!Array.isArray(options) || options.length < 2) {
                errors.push(`${position} is a choice, so it needs at least two options.`);
            } else {
                if (options.length > MAX_OPTIONS) {
                    errors.push(`${position} has ${options.length} options; the limit is ${MAX_OPTIONS}. `
                        + 'A long numbered list is hard to read on a phone.');
                }
                const seenValues = new Set();
                options.forEach((option, optionIndex) => {
                    const where = `${position}, option ${optionIndex + 1}`;
                    if (!option || typeof option !== 'object') {
                        errors.push(`${where} is not an option.`);
                        return;
                    }
                    if (!isFilledString(option.value)) {
                        errors.push(`${where} needs a stored value.`);
                    } else if (seenValues.has(option.value)) {
                        errors.push(`${where}: the value "${option.value}" is repeated.`);
                    } else {
                        seenValues.add(option.value);
                    }
                    checkTranslated(option.label, `${where}'s label`, errors, { max: 100 });
                });
            }
        } else if (step.options !== undefined) {
            warnings.push(`${position} is a ${step.type} question, so its options will be ignored.`);
        }

        if (step.validation !== undefined) {
            if (typeof step.validation !== 'object' || Array.isArray(step.validation)) {
                errors.push(`${position}: validation must be an object.`);
            } else {
                const { pattern } = step.validation;
                if (pattern !== undefined) {
                    if (!isFilledString(pattern)) {
                        errors.push(`${position}: the validation pattern must be text.`);
                    } else {
                        try {
                            // Compiled here so a broken pattern is rejected at
                            // save time rather than discovered by a citizen
                            // being told their answer is wrong forever.
                            // eslint-disable-next-line no-new
                            new RegExp(pattern);
                        } catch (err) {
                            errors.push(`${position}: the validation pattern is not valid — ${err.message}`);
                        }

                        if (step.type === 'choice') {
                            warnings.push(`${position} is a choice, so its validation pattern will be ignored.`);
                        }
                    }

                    if (isFilledString(pattern) && !step.validation.error) {
                        warnings.push(`${position} rejects answers that do not match its pattern, `
                            + 'but has no message explaining what is expected. The citizen will only be told they are wrong.');
                    }
                }
                if (step.validation.error !== undefined) {
                    checkTranslated(step.validation.error, `${position}'s validation message`, errors,
                        { required: false, max: 300 });
                }
            }
        }

        if (step.skippable === false && step.validation && step.validation.pattern) {
            warnings.push(`${position} cannot be skipped and only accepts answers matching a pattern. `
                + 'Anyone who does not have that information has no way past this question.');
        }
    });

    return { errors, warnings };
}

module.exports = { validateDefinition, STEP_TYPES, MAX_STEPS, ADVISORY_STEP_COUNT };
