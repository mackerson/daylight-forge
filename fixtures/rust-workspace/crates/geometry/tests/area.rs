mod common;

use geometry_core::shapes::circle::Circle;
use geometry_core::Shape;

#[test]
fn unit_circle_area() {
    let circle = Circle::new(1.0);
    assert!(common::close(circle.area(), 6.28));
}
