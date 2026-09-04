fn main() {
    napi_build::setup();
    let output = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let object = output.join("safe_fs.o");
    let journal_object = output.join("source_journal.o");
    let library = output.join("libcorptie_safe_fs.a");
    let compile = std::process::Command::new("/usr/bin/cc")
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-c", "src/safe_fs.c", "-o"])
        .arg(&object)
        .status()
        .expect("compile safe_fs.c");
    assert!(compile.success(), "safe_fs.c compilation failed");
    let journal_compile = std::process::Command::new("/usr/bin/cc")
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-c", "src/source_journal.c", "-o"])
        .arg(&journal_object)
        .status()
        .expect("compile source_journal.c");
    assert!(journal_compile.success(), "source_journal.c compilation failed");
    let archive = std::process::Command::new("/usr/bin/ar")
        .arg("crus")
        .arg(&library)
        .arg(&object)
        .arg(&journal_object)
        .status()
        .expect("archive safe_fs.o");
    assert!(archive.success(), "safe_fs archive failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=corptie_safe_fs");
    println!("cargo:rerun-if-changed=src/safe_fs.c");
    println!("cargo:rerun-if-changed=src/source_journal.c");
}
