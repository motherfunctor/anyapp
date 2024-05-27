const { watch } = require("node:fs");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const process = require("node:process");
const joinArr = require("lodash/fp/join.js");
const get = require("lodash/fp/get.js");
const noop = require("lodash/fp/noop.js");
const always = require("lodash/fp/always.js");
const template = require("lodash/fp/template.js");
const less = require("less");
const kefir = require("kefir");
const LessPluginCleanCSS = require("less-plugin-clean-css");
const { context, formatMessages } = require("esbuild");

const DIST_FOLDER = join(__dirname, "dist");
const SRC_FOLDER = join(__dirname, "src");
const DEV_MODE = process.env["NODE_ENV"] === "development";

const fileToProperty = (filename) =>
  kefir.fromPromise(readFile(filename, "utf8")).toProperty();

const propertyToFile = (filename) => (property) =>
  property.flatMap((fileContent) =>
    kefir.concat([
      kefir
        .fromPromise(mkdir(dirname(filename), { recursive: true }))
        .ignoreValues(),
      kefir.fromPromise(writeFile(filename, fileContent, { recursive: true }))
    ])
  );

const transformLess =
  (compilerOptions = {}) =>
  (stream) =>
    stream
      .flatMap((lessText) =>
        kefir.fromPromise(less.render(lessText, compilerOptions))
      )
      .map(get("css"));

const transformJs = (compilerOptions = {}) => {
  return kefir
    .fromPromise(context(compilerOptions))
    .flatMap((context) => kefir.fromPromise(context.rebuild()))
    .map(get("outputFiles.0.text"));
};

const fsChangeStream = (folder) =>
  kefir
    .stream(({ value }) => {
      const watcher = watch(folder, { recursive: true }, value);
      return () => watcher.close();
    })
    .debounce(0);

const buildProject = () =>
  kefir
    .combine(
      [
        fileToProperty(join(SRC_FOLDER, "main.ejs")),
        transformJs({
          entryPoints: [join(SRC_FOLDER, "main.js")],
          bundle: true,
          write: false,
          platform: "browser",
          minify: !DEV_MODE,
          sourcemap: DEV_MODE,
          format: "esm",
          target: ["esnext"],
          logLevel: "silent",
          keepNames: DEV_MODE,
          treeShaking: true
        }).flatMapErrors((results) => {
          const FORMAT_TYPES = {
            errors: { kind: "error" },
            warnings: { kind: "warning" }
          };

          return kefir.merge(
            Object.entries(results).map(([resultType, resultInfo]) => {
              return kefir
                .fromPromise(
                  formatMessages(resultInfo, {
                    ...(FORMAT_TYPES[resultType] ?? {}),
                    color: true
                  })
                )
                .map(joinArr("\n"))
                .flatMap(kefir.constantError);
            })
          );
        }),
        fileToProperty(join(SRC_FOLDER, "main.less")).thru(
          transformLess({
            plugins: [new LessPluginCleanCSS({ advanced: true })]
          })
        )
      ],
      (html, compiledCode, compiledLess) => {
        return template(html)({
          STYLE: `<style>${compiledLess}</style>`,
          CODE: `<script>${compiledCode}</script>`,
          TITLE: `My Application`
        });
      }
    )
    .thru(propertyToFile(join(DIST_FOLDER, "main.html")));

fsChangeStream(SRC_FOLDER)
  .toProperty(noop)
  .flatMapLatest(buildProject)
  .takeWhile(always(DEV_MODE))
  .onError(console.warn)
  .onEnd(() => process.exit(0));
