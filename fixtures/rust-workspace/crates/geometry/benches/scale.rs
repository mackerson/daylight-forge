use geometry_core::units::scale;

fn main() {
    let total: f64 = (0..1000).map(|i| scale(i as f64)).sum();
    println!("{}", total);
}
