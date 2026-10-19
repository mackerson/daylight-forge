use crate::units::Length;

pub fn approx(a: Length, b: Length) -> bool {
    (a - b).abs() < 1e-9
}
