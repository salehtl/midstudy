//! `cargo run -p midstudy-product --example probe -- <op> '<json>'`: one call of the JSON face, for debugging.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(op), Some(input)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: probe <op> <json>");
        std::process::exit(2);
    };
    println!("{}", midstudy_product::api::call(op, input));
}
