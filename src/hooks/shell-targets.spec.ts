import { describe, expect, it } from "vitest";
import { analyzeShellMutation } from "./shell-targets.js";

describe("analyzeShellMutation", () => {
  it("extracts literal redirects, tee targets, and quoted paths", () => {
    expect(analyzeShellMutation("printf x > src/a.ts && echo y | tee -a 'src/b file.ts'")).toEqual({
      mutation: "resolved",
      paths: ["src/a.ts", "src/b file.ts"],
    });
  });

  it("extracts literal copy, move, remove, and in-place targets", () => {
    expect(analyzeShellMutation("cp a.ts out/b.ts; mv old.ts new.ts; rm dead.ts").paths).toEqual([
      "out/b.ts",
      "old.ts",
      "new.ts",
      "dead.ts",
    ]);
    expect(analyzeShellMutation("sed -i 's/a/b/' src/a.ts").paths).toEqual(["src/a.ts"]);
    expect(analyzeShellMutation("truncate -s 0 data.bin").paths).toEqual(["data.bin"]);
    expect(analyzeShellMutation("mkdir -m 755 build").paths).toEqual(["build"]);
    expect(analyzeShellMutation("touch -t 202601010000 stamp.txt").paths).toEqual(["stamp.txt"]);
    expect(analyzeShellMutation("cp a.ts b.ts > copy.log").paths).toEqual(["copy.log", "b.ts"]);
  });

  it("parses sed in-place suffixes and repeated program options without treating programs as files", () => {
    expect(
      analyzeShellMutation(
        "sed --in-place=.bak -e 's/a/b/' -e 's/c/d/' --file rules.sed a.txt b.txt",
      ),
    ).toEqual({ mutation: "resolved", paths: ["a.txt", "b.txt"] });
    expect(analyzeShellMutation("sed -ni.bak -e 's/a/b/' a.txt")).toEqual({
      mutation: "resolved",
      paths: ["a.txt"],
    });
  });

  it("extracts literal Python write targets, including a heredoc body", () => {
    const command = `python - <<'PY'\nfrom pathlib import Path\nPath("src/a.ts").write_text("x")\nopen('src/b.ts', 'wb').write(b'x')\nPY`;
    expect(analyzeShellMutation(command)).toEqual({
      mutation: "resolved",
      paths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("extracts literal inline Python writes and write-capable r+ mode", () => {
    expect(
      analyzeShellMutation(
        `python -c "Path('src/a.ts').write_text('x'); open('state.db', 'r+').write('x')"`,
      ),
    ).toEqual({ mutation: "resolved", paths: ["src/a.ts", "state.db"] });
    expect(
      analyzeShellMutation(
        `python -c "open('src/keyword.ts', mode='w'); Path('src/path-keyword.ts').open(mode='wb')"`,
      ),
    ).toEqual({
      mutation: "resolved",
      paths: ["src/keyword.ts", "src/path-keyword.ts"],
    });
    expect(
      analyzeShellMutation(
        `python -c "open(file='src/named.ts', mode='w').write('x'); open(mode='wb', file='src/reversed.ts')"`,
      ),
    ).toEqual({
      mutation: "resolved",
      paths: ["src/named.ts", "src/reversed.ts"],
    });
  });

  it("retains literal Python targets but warns when another target is dynamic", () => {
    expect(
      analyzeShellMutation(
        `python -c "Path('src/known.ts').write_text('x'); Path(target).write_text('x')"`,
      ),
    ).toEqual({
      mutation: "unresolved",
      paths: ["src/known.ts"],
      reason: "dynamic_target",
    });
  });

  it("extracts every literal Perl in-place target", () => {
    expect(analyzeShellMutation("perl -pi -e 's/a/b/' a.txt b.txt")).toEqual({
      mutation: "resolved",
      paths: ["a.txt", "b.txt"],
    });
  });

  it("does not interpret comments or non-Python heredoc bodies as shell syntax", () => {
    expect(analyzeShellMutation("echo ok # > fake.ts\nrg TODO src")).toEqual({
      mutation: "none",
      paths: [],
    });
    expect(analyzeShellMutation("cat <<'EOF'\n> fake.ts\nEOF")).toEqual({
      mutation: "none",
      paths: [],
    });
    expect(analyzeShellMutation(`echo "<<EOF"`)).toEqual({ mutation: "none", paths: [] });
    expect(analyzeShellMutation("cat <<< literal")).toEqual({ mutation: "none", paths: [] });
  });

  it("marks an unresolvable heredoc delimiter unverified instead of scanning its body", () => {
    expect(analyzeShellMutation("cat <<$DELIMITER\n> fake.ts\nDELIMITER")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
    expect(analyzeShellMutation('python <<PY\nPath("$OUT").write_text("x")\nPY')).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
  });

  it("does not treat Python comments or prose strings as resolved writes", () => {
    const command = `python - <<'PY'\n# Path("fake.ts").write_text("x")\nprint('Path("also-fake.ts").write_text("x")')\nPY`;
    expect(analyzeShellMutation(command)).toMatchObject({ mutation: "unresolved", paths: [] });
    expect(
      analyzeShellMutation(`python -c "print('hello; Path(\\"fake.ts\\").write_text(\\"x\\")')"`),
    ).toMatchObject({ mutation: "unresolved", paths: [] });
  });

  it("associates heredoc bodies only with their owning Python command", () => {
    const command = `cat <<'EOF'\nPath("fake.ts").write_text("x")\nEOF\npython -c 'print("ok")'`;
    expect(analyzeShellMutation(command)).toEqual({ mutation: "none", paths: [] });
  });

  it("never expands dynamic targets and marks partial resolution unverified", () => {
    expect(analyzeShellMutation('printf x > "$OUT"; tee src/known.ts > /dev/null')).toEqual({
      mutation: "unresolved",
      paths: ["src/known.ts"],
      reason: "dynamic_target",
    });
    expect(analyzeShellMutation("echo x | tee src/known.ts >(cat)")).toEqual({
      mutation: "unresolved",
      paths: ["src/known.ts"],
      reason: "dynamic_target",
    });
    expect(analyzeShellMutation("printf x > >(cat)")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
    expect(analyzeShellMutation("touch 'src/a '")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
  });

  it("does not classify read-only commands as mutations", () => {
    expect(analyzeShellMutation("rg -n TODO src && git status --short")).toEqual({
      mutation: "none",
      paths: [],
    });
    expect(analyzeShellMutation("rg TODO src 2>/dev/null")).toEqual({
      mutation: "none",
      paths: [],
    });
    expect(analyzeShellMutation("rg TODO src 2>&1")).toEqual({ mutation: "none", paths: [] });
    expect(analyzeShellMutation(`echo 'Path("src/x").write_text("x")'`)).toEqual({
      mutation: "none",
      paths: [],
    });
  });

  it("warns instead of guessing unsupported target options or expansions", () => {
    expect(analyzeShellMutation("cp -t dist a.ts b.ts")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
    expect(analyzeShellMutation("printf x > /tmp/$NAME")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
    expect(analyzeShellMutation("cp a.ts b.ts dist")).toMatchObject({
      mutation: "unresolved",
      paths: ["dist"],
    });
    expect(analyzeShellMutation("mv old.ts maybe-directory")).toMatchObject({
      mutation: "unresolved",
      paths: ["old.ts", "maybe-directory"],
    });
    expect(analyzeShellMutation("rm -rf Sources")).toMatchObject({
      mutation: "unresolved",
      paths: ["Sources"],
    });
    expect(analyzeShellMutation("rm --recursive Sources")).toMatchObject({
      mutation: "unresolved",
      paths: ["Sources"],
    });
    expect(analyzeShellMutation("rm -- -recursive-looking-name")).toEqual({
      mutation: "resolved",
      paths: ["-recursive-looking-name"],
    });
  });

  it("never resolves targets against the wrong cwd after a shell directory change", () => {
    expect(analyzeShellMutation("cd PersonalModel && printf x > Sources/App.swift")).toEqual({
      mutation: "unresolved",
      paths: [],
      reason: "unresolved_mutation",
    });
    expect(analyzeShellMutation("(cd PersonalModel && touch Sources/App.swift)")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
    expect(analyzeShellMutation("env --chdir=PersonalModel touch Sources/App.swift")).toMatchObject(
      { mutation: "unresolved", paths: [] },
    );
    expect(analyzeShellMutation("env -C PersonalModel touch Sources/App.swift")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
  });

  it("unwraps deterministic env assignments and warns on ambiguous env command synthesis", () => {
    expect(analyzeShellMutation("env FOO=bar touch src/a.ts")).toEqual({
      mutation: "resolved",
      paths: ["src/a.ts"],
    });
    expect(analyzeShellMutation("env -S 'touch src/a.ts'")).toMatchObject({
      mutation: "unresolved",
      paths: [],
    });
  });
});
