const logger = require('../services/logger');

/**
 * simple-task-queue.js
 * A lightweight in-memory queue to limit concurrent execution of async tasks.
 * Used to prevent overloading the local AI server.
 */
class TaskQueue {
    /**
     * @param {number} concurrency - Max number of tasks to run in parallel.
     */
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    /**
     * Add a task to the queue.
     * @param {Function} task - A function that returns a Promise.
     * @returns {Promise} - Resolves or rejects when the task completes.
     */
    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.next();
        });
    }

    next() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }

        const { task, resolve, reject } = this.queue.shift();
        this.running++;

        // Execute task
        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.running--;
                this.next();
            });
    }

    get length() {
        return this.queue.length;
    }

    get active() {
        return this.running;
    }
}

module.exports = TaskQueue;
