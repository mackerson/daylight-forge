use super::{Named, Shape};
use crate::units::scale;

#[derive(Debug)]
pub struct Circle {
    pub radius: f64,
    pub label: String,
}

impl Circle {
    pub fn new(radius: f64) -> Self {
        Circle { radius, label: String::from("circle") }
    }
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        scale(3.14 * crate::square!(self.radius))
    }
}

impl Named for Circle {
    fn name(&self) -> String {
        self.label.clone()
    }
}
