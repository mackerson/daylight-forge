mod format;

pub fn print_total(total: f64) {
    println!("total area: {}", format::two_places(total));
}
