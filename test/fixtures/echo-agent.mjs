// A raw stdio process: preserve arbitrary byte boundaries and expose its PID for lifecycle tests.
process.stdout.write(`${process.pid}\n`);
process.stdin.pipe(process.stdout);
