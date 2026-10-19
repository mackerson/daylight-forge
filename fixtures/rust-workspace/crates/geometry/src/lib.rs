//! A tiny two-crate workspace for Daylight's Rust provider tests. Data, never compiled.

pub mod shapes;
pub mod units;

#[cfg(test)]
mod testing;

pub use self::shapes::Shape;

#[macro_export]
macro_rules! square {
    ($x:expr) => {
        $x * $x
    };
}

pub fn total_area(items: &[Box<dyn Shape>]) -> f64 {
    items.iter().map(|s| s.area()).sum()
}
