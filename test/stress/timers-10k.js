// M1 exit criterion: 10k timers created/cleared in a loop keeps RSS flat.
// Run under lite and watch max RSS: `./test/stress/run.sh`.
const rounds = 20;
for (let round = 0; round < rounds; round++) {
  for (let i = 0; i < 10000; i++) {
    clearTimeout(setTimeout(() => {}, 1000));
  }
}
setTimeout(() => console.log('timers-10k ok', rounds), 0);
