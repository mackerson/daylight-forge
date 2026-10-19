pub mod circle;

pub trait Named {
    fn name(&self) -> String;
}

pub trait Shape: std::fmt::Debug + Named {
    fn area(&self) -> f64;

    fn describe(&self) -> String {
        format!("{} with area {}", self.name(), self.area())
    }
}
