mod report;

use geometry_core::shapes::circle::Circle;
use geometry_core::total_area as sum_areas;

fn main() {
    let circle = Circle::new(1.5);
    let total = sum_areas(&[Box::new(circle)]);
    report::print_total(total);
}
