# Contributing to Corkboard

Contributions are welcome. A few things make them easy to take in.

- **Run and test.** `npm install`, then `npm run dev` (see the README's *Running*). Before a pull request: `npm run typecheck`, `npm test`, and `npm run e2e`, which builds the app and drives it on a scratch clone of a board repo, with a stand-in for `claude` so nothing real is started or billed (the README's *Tests*).
- **Commits** say what changed and why. A change for a card on the project's board ends its message with a `Card: <ID>` trailer (`Card: CORK-11`): Corkboard shows that commit on the card.
- **Sign off every commit** (`git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>`). It certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org): that you wrote the change, or otherwise have the right to submit it under the project's license. There is no contributor license agreement.
- **License.** Contributions come in under the project's license, the GNU GPL version 3 or (at your option) any later version ([LICENSE](LICENSE)), and you keep the copyright on your part.
- **AI-assisted contributions** are welcome, as long as the commit says so: a `Co-Authored-By:` trailer naming the model, as this repo's own commits carry, or a line in the message. Read and test what you submit: the sign-off is your certification, not the tool's.
