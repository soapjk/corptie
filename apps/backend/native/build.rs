fn main() {
    napi_build::setup();
    let output = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let object = output.join("safe_fs.o");
    let library = output.join("libcorptie_safe_fs.a");
    let compile = std::process::Command::new("/usr/bin/cc")
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-c", "src/safe_fs.c", "-o"])
        .arg(&object)
        .status()
        .expect("compile safe_fs.c");
    assert!(compile.success(), "safe_fs.c compilation failed");
    let archive = std::process::Command::new("/usr/bin/ar")
        .arg("crus")
        .arg(&library)
        .arg(&object)
        .status()
        .expect("archive safe_fs.o");
    assert!(archive.success(), "safe_fs archive failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=corptie_safe_fs");
    println!("cargo:rerun-if-changed=src/safe_fs.c");
}
