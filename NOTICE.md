# Attribution

The blackbox binary decoder in `src/tools.js`, `src/datastream.js`,
`src/decoders.js`, and `src/decoder.js` is adapted from the
[Betaflight blackbox-log-viewer](https://github.com/betaflight/blackbox-log-viewer)
project (`src/tools.js`, `src/datastream.js`, `src/decoders.js`,
`src/flightlog_parser.js`).

Original work Copyright (C) Nicholas Sherlock and contributors, licensed
under the GNU General Public License v3.0 (see [LICENSE](LICENSE)).

Because this project incorporates that GPL-3.0 code, this repository as a
whole is licensed under GPL-3.0. See the header comment in each adapted
file for a summary of the changes made during the port (removing GPS
support, removing the `semver` npm dependency, converting from ES modules
to plain scripts, etc — per GPL-3.0 section 5a).
