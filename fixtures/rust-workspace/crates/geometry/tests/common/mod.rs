pub fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}
