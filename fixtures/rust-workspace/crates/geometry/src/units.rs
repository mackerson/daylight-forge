pub const SCALE: f64 = 2.0;
pub static UNIT_NAME: &str = "metre";

pub type Length = f64;

pub enum Unit {
    Metres,
    Feet(f64),
    Custom { name: String },
}

pub fn scale(value: Length) -> Length {
    value * SCALE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles() {
        assert_eq!(scale(1.5), 3.0);
    }
}
